targetScope = 'resourceGroup'

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Azure region')
param location string

@description('Common resource tags')
param tags object

@description('VNet address space')
param vnetAddressPrefix string

@description('App Service integration subnet prefix')
param appServiceSubnetPrefix string

@description('MySQL delegated subnet prefix')
param mysqlSubnetPrefix string

@description('Private Endpoint subnet prefix')
param privateEndpointSubnetPrefix string


@description('NSG resource ID for App Service integration subnet')
param appNsgId string

@description('NSG resource ID for MySQL subnet')
param mysqlNsgId string

@description('NSG resource ID for Private Endpoint subnet')
param privateEndpointNsgId string

@description('Address prefix of the temporary DB-migration subnet that exists in production (snet-migration-temp). Empty = not declared. It is declared only so that a deployment of this template does not try to delete a subnet that still holds the migration VM NIC; clear it when the migration leftovers have been decommissioned.')
param migrationSubnetPrefix string = ''

@description('Resource ID of the existing NSG on the migration subnet (nsg-migration-temp, created by hand). Used only together with migrationSubnetPrefix.')
param migrationNsgId string = ''

var vnetName = 'vnet-${workloadName}-${environment}-${instance}'

var migrationSubnets = empty(migrationSubnetPrefix) ? [] : [
  {
    name: 'snet-migration-temp'
    properties: {
      addressPrefix: migrationSubnetPrefix
      networkSecurityGroup: empty(migrationNsgId) ? null : {
        id: migrationNsgId
      }
    }
  }
]

resource vnet 'Microsoft.Network/virtualNetworks@2023-02-01' = {
  name: vnetName
  location: location
  tags: tags

  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }

    subnets: concat([
      {
        name: 'snet-appservice-integration'
        properties: {
          addressPrefix: appServiceSubnetPrefix

          networkSecurityGroup: {
            id: appNsgId
          }
          delegations: [
            {
              name: 'appservice-delegation'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }

      {
        name: 'snet-mysql'
        properties: {
          addressPrefix: mysqlSubnetPrefix

          networkSecurityGroup: {
            id: mysqlNsgId
          }
          delegations: [
            {
              name: 'mysql-delegation'
              properties: {
                serviceName: 'Microsoft.DBforMySQL/flexibleServers'
              }
            }
          ]
        }
      }

      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix

          networkSecurityGroup: {
            id: privateEndpointNsgId
          }
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
    ], migrationSubnets)
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name


output mysqlSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-mysql')

output appserviceSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-appservice-integration')

output privateEndpointSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-private-endpoints')
