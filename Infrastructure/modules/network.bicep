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

var vnetName = 'vnet-${workloadName}-${environment}-${instance}'

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

    subnets: [
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
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name


output mysqlSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-mysql')

output appserviceSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-appservice-integration')

output privateEndpointSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'snet-private-endpoints')
