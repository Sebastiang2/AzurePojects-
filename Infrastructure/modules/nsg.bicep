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

@description('App Service integration subnet prefix')
param appServiceSubnetPrefix string

@description('MySQL subnet prefix')
param mysqlSubnetPrefix string

@description('Private Endpoint subnet prefix')
param privateEndpointSubnetPrefix string



//Network Security Groups naming. Same naming convention is used for all NSGs to avoid name conflicts in the same resource group.

var appNSGName = 'nsg-${workloadName}-${environment}-${instance}'

var mysqlNSGName = 'nsg-mysql-${workloadName}-${environment}-${instance}'

var privateEndpointNSGName = 'nsg-privateendpoint-${workloadName}-${environment}-${instance}'


// App Service NSG
resource appNSG 'Microsoft.Network/networkSecurityGroups@2023-02-01' = {
  name: appNSGName
  location: location
  tags: tags

  properties: {
    securityRules: [

      // App Service -> MySQL
      {
        name: 'Allow-MySQL'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'

          sourcePortRange: '*'
          destinationPortRange: '3306'

          sourceAddressPrefix: appServiceSubnetPrefix
          destinationAddressPrefix: mysqlSubnetPrefix
        }
      }

      // App Service -> Private Endpoints
      {
        name: 'Allow-PrivateEndpoints-HTTPS'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'

          sourcePortRange: '*'
          destinationPortRange: '443'

          sourceAddressPrefix: appServiceSubnetPrefix
          destinationAddressPrefix: privateEndpointSubnetPrefix
        }
      }

    

      // Block other private VNet destinations
      {
        name: 'Deny-Other-VNet-Outbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'

          sourcePortRange: '*'
          destinationPortRange: '*'

          sourceAddressPrefix: '*'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
    ]
  }
}


// The MySQL NSG is configured to allow inbound traffic from the App Service subnet and outbound traffic to Azure DNS. All other inbound and outbound traffic is denied.
resource mysqlNSG 'Microsoft.Network/networkSecurityGroups@2023-02-01' = {
  name: mysqlNSGName
  location: location
  tags: tags

  properties: {
    securityRules: [
      {
        name: 'Allow-AppService-MySQL'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'

          sourcePortRange: '*'
          destinationPortRange: '3306'

          sourceAddressPrefix: appServiceSubnetPrefix
          destinationAddressPrefix: mysqlSubnetPrefix
        }
      }

      {
        name: 'Allow-MySQL-Subnet-MySQL'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'

          sourcePortRange: '*'
          destinationPortRange: '3306'

          sourceAddressPrefix: mysqlSubnetPrefix
          destinationAddressPrefix: mysqlSubnetPrefix
        }
      }

      {
        name: 'Deny-Other-VNet-MySQL'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: 'Tcp'

          sourcePortRange: '*'
          destinationPortRange: '3306'

          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: mysqlSubnetPrefix
        }
      }
    ]
  }
}

resource privateEndpointNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: privateEndpointNSGName
  location: location
  tags: tags

  properties: {
    securityRules: [
      {
        name: 'Allow-AppService-HTTPS'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'

          sourcePortRange: '*'
          destinationPortRange: '443'

          sourceAddressPrefix: appServiceSubnetPrefix
          destinationAddressPrefix: privateEndpointSubnetPrefix
        }
      }
    ]
  }
}

output appNsgId string = appNSG.id
output mysqlNsgId string = mysqlNSG.id
output privateEndpointNsgId string = privateEndpointNsg.id
