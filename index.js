module.exports = function (sails) {
    var Sequelize = require('sequelize');

    return {
        defaults: {
            __configKey__: {
                clsNamespace: 'sails-sequelize',
                exposeToGlobal: true
            }
        },
        configure: function () {
            var cls = sails.config[this.configKey].clsNamespace;
            // If custom log function is specified, use it for SQL logging or use sails logger of defined level
            if (typeof cls === 'string' && cls !== '') {
                Sequelize.useCLS(require('continuation-local-storage').createNamespace(cls));
            }
        },
        initialize: function (next) {
            this.initAdapters();
            this.initModels();
            this.reload(next);
        },

        reload: function (next) {
            var connections, self = this;

            connections = this.initConnections();

            if (sails.config[this.configKey].exposeToGlobal) {
                sails.log.verbose('Exposing Sequelize and Sequelize connections globally');
                global['Sequelize'] = Sequelize;
                global['SequelizeConnections'] = connections;
            }

            return sails.modules.loadModels(function (err, models) {

                if (err) {
                    return next(err);
                }

                self.defineModels(models, connections);
                self.migrateSchema(next, connections, models);
            });
        },

        initAdapters: function () {
            if (typeof (sails.adapters) === 'undefined') {
                sails.adapters = {};
            }
        },

        initConnections: function () {
            var connections = {}, connection, connectionName;

            // Try to read settings from old Sails then from the new.
            // 0.12: sails.config.connections & sails.config.models.connection
            // 1.00: sails.config.datastores & sails.config.models.datastore
            var datastores = sails.config.connections || sails.config.datastores;
            var datastoreName = sails.config.models.connection || sails.config.models.datastore || 'default';

            sails.log.verbose('Using default connection named ' + datastoreName);
            if (!datastores.hasOwnProperty(datastoreName)) {
                throw new Error('Default connection \'' + datastoreName + '\' not found in config/connections');
            }

            for (connectionName in datastores) {
                connection = datastores[connectionName];

                if (!connection.options) {
                    connection.options = {};
                }

                // If custom log function is specified, use it for SQL logging or use sails logger of defined level
                if (typeof connection.options.logging === 'string' && connection.options.logging !== '') {
                    connection.options.logging = sails.log[connection.options.logging];
                }

                if (connection.url) {
                    connections[connectionName] = new Sequelize(connection.url, connection.options);
                } else {
                    connections[connectionName] = new Sequelize(connection.database,
                        connection.user,
                        connection.password,
                        connection.options);
                }
            }

            return connections;
        },

        initModels: function () {
            if (typeof (sails.models) === 'undefined') {
                sails.models = {};
            }
        },

        defineModels: function (models, connections) {
            var modelDef, modelName, modelClass, cm, im, connectionName,
                sequelizeMajVersion = parseInt(Sequelize.version.split('.')[0], 10);

            // Try to read settings from old Sails then from the new.
            // 0.12: sails.config.models.connection
            // 1.00: sails.config.models.datastore
            var defaultConnection = sails.config.models.connection || sails.config.models.datastore || 'default';
            
            for (modelName in models) {
                modelDef = models[modelName];
                sails.log.verbose('Loading model \'' + modelDef.globalId + '\'');

                connectionName = modelDef.options.connection || modelDef.datastore || defaultConnection;

                modelClass = connections[connectionName].define(modelDef.globalId, modelDef.attributes, modelDef.options);

                if (sequelizeMajVersion >= 4) {
                    for (cm in modelDef.options.classMethods) {
                        modelClass[cm] = modelDef.options.classMethods[cm];
                    }

                    for (im in modelDef.options.instanceMethods) {
                        modelClass.prototype[im] = modelDef.options.instanceMethods[im];
                    }
                }

                if (sails.config.globals.models) {
                    sails.log.verbose('Exposing model \'' + modelDef.globalId + '\' globally');
                    global[modelDef.globalId] = modelClass;
                }
                sails.models[modelDef.globalId.toLowerCase()] = modelClass;
            }

            for (modelName in models) {
                modelDef = models[modelName];
                this.setAssociation(modelDef);
                this.setDefaultScope(modelDef);
            }

        },

        setAssociation: function (modelDef) {
            if (modelDef.associations !== null) {
                sails.log.verbose('Loading associations for \'' + modelDef.globalId + '\'');
                if (typeof modelDef.associations === 'function') {
                    modelDef.associations(modelDef);
                }
            }
        },

        setDefaultScope: function (modelDef) {
            if (modelDef.defaultScope !== null) {
                sails.log.verbose('Loading default scope for \'' + modelDef.globalId + '\'');
                var model = global[modelDef.globalId];
                if (typeof modelDef.defaultScope === 'function') {
                    var defaultScope = modelDef.defaultScope() || {};
                    model.addScope('defaultScope', defaultScope, { override: true });
                }
            }
        },

        migrateSchema: function (next, connections, models) {
            var connectionDescription, connectionName, migrate, forceSync, syncTasks = [];
          
            // Try to read settings from old Sails then from the new.
            // 0.12: sails.config.connections
            // 1.00: sails.config.datastores
            var datastores = sails.config.connections || sails.config.datastores;

            migrate = sails.config.models.migrate;
            sails.log.verbose('Models migration strategy: ' + migrate);

            if (migrate === 'safe') {
                return next();
            } else {
                forceSync = migrate === 'drop';

                for (connectionName in datastores) {
                    connectionDescription = datastores[connectionName];

                    sails.log.verbose('Migrating schema in \'' + connectionName + '\' connection');

                    if (connectionDescription.dialect === 'postgres') {

                        syncTasks.push(connections[connectionName].showAllSchemas().then(function (schemas) {
                            var modelName, modelDef, tableSchema;

                            for (modelName in models) {
                                modelDef = models[modelName];
                                tableSchema = modelDef.options.schema || '';

                                if (tableSchema !== '' && schemas.indexOf(tableSchema) < 0) { // there is no schema in db for model
                                    connections[connectionName].createSchema(tableSchema);
                                    schemas.push(tableSchema);
                                }
                            }

                            return connections[connectionName].sync({ force: forceSync });
                        }));

                    } else {
                        syncTasks.push(connections[connectionName].sync({ force: forceSync }));
                    }

                    Promise.all(syncTasks).then(function () {
                        return next();
                    }).catch(function (e) {
                        return next(e);
                    });
                }
            }
        }
    };
};
