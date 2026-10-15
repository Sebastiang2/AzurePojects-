
targetScope = 'resourceGroup'

param workloadName string
param environment string
param instance string
param location string
param tags object

param mysqlSubnetId string
param privateDnsZoneMysqlId string

// What this deployment does with the MySQL server. API version 2024-12-30 of Microsoft.DBforMySQL/flexibleServers documents
// administratorLogin as "can only be specified when the server is being created (and is required for creation)" and
// administratorLoginPassword as "required for server creation". Azure never returns the password and does not say what a PUT
// without it does to an existing server, so a redeploy must not depend on that:
//
//   existing  The server resource is NOT part of the deployment. Nothing is written to it, so the administrator password and
//             every server property stay exactly as they are. Only the database below is (re)declared, and the outputs are read
//             from the existing server. This is the mode for every normal redeploy.
//   update    The server is PUT without administratorLogin and administratorLoginPassword (the two properties that belong to
//             creation) to reconcile its other properties. Deliberate: the safety gate stops it unless the manifest records
//             the approval (deployments.<key>.mysqlServer.mode = 'update').
//   create    The server is created with login and password. For a server that does not exist yet (new environment or
//             recovery). The gate stops it when the server already exists.
@allowed([
  'existing'
  'update'
  'create'
])
param mysqlServerMode string = 'existing'

param mysqlAdminUsername string

// Read ONLY when mysqlServerMode is 'create'. The default is empty on purpose: there is no placeholder or dummy value that
// could ever be sent to a server. The parameter file reads it from the environment when (and only when) a server is created.
@secure()
param mysqlAdminPassword string = ''

param mysqlSkuName string
param mysqlSkuTier string
param mysqlVersion string
param storageSizeGB int
param backupRetentionDays int
param highAvailabilityMode string

@description('DatabaseName')
param databaseName string

var mysqlServerName = 'mysql-${workloadName}-${environment}-${instance}'
var mysqlServerIsWritten = mysqlServerMode != 'existing'
var mysqlServerIsCreated = mysqlServerMode == 'create'

// Always declared as existing: outputs and the database's parent are read from it in every mode. In 'create' mode the
// reference is resolved after the server below has been created (outputs are evaluated at the end of the deployment).
resource mysqlServerExisting 'Microsoft.DBforMySQL/flexibleServers@2024-12-30' existing = {
  name: mysqlServerName
}

resource mysqlServer 'Microsoft.DBforMySQL/flexibleServers@2024-12-30' = if (mysqlServerIsWritten) {
  name: mysqlServerName
  location: location
  tags: tags

  sku: {
    name: mysqlSkuName
    tier: mysqlSkuTier
  }

  // The creation-only properties are added by union() only in 'create' mode, so that in every other mode they are absent from
  // the request (not null, not empty): administratorLogin and administratorLoginPassword.
  properties: union(
    {
      version: mysqlVersion

      network: {
        delegatedSubnetResourceId: mysqlSubnetId
        privateDnsZoneResourceId: privateDnsZoneMysqlId
        publicNetworkAccess: 'Disabled'
      }

      backup: {
        backupRetentionDays: backupRetentionDays
        geoRedundantBackup: 'Disabled'
      }

      highAvailability: {
        mode: highAvailabilityMode
      }

      storage: {
        storageSizeGB: storageSizeGB
        autoGrow: 'Enabled'
        autoIoScaling: 'Disabled'
      }
    },
    mysqlServerIsCreated
      ? {
          administratorLogin: mysqlAdminUsername
          administratorLoginPassword: mysqlAdminPassword
        }
      : {}
  )
}

resource appDatabase 'Microsoft.DBforMySQL/flexibleServers/databases@2024-12-30' = {
  parent: mysqlServerExisting
  name: databaseName

  // The server is created first when this deployment creates it (ignored when the server is not part of the deployment).
  dependsOn: [
    mysqlServer
  ]

  properties: {
    charset: 'utf8mb4'
    // The collation the production database was created with (MySQL 8 default).
    collation: 'utf8mb4_0900_ai_ci'
  }
}


output mysqlServerId string = mysqlServerExisting.id
output mysqlServerName string = mysqlServerExisting.name
output mysqlFqdn string = mysqlServerExisting.properties.fullyQualifiedDomainName


output mysqlServerFqdn string = mysqlServerExisting.properties.fullyQualifiedDomainName
output databaseName string = appDatabase.name
