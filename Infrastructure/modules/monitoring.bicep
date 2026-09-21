targetScope = 'resourceGroup'

@description('Azure region for monitoring resources')
param location string

@description('Workload name')
param workloadName string

@description('Environment name')
param environment string

@description('Instance identifier')
param instance string

@description('Common resource tags')
param tags object

@description('Log Analytics retention in days')
param retentionInDays int = 30

@description('Daily Log Analytics ingestion cap in GB')
param dailyQuotaGb int = 1

var logAnalyticsName = 'log-${workloadName}-${environment}-${instance}'
var authAppInsightsName = 'appi-${workloadName}-auth-api-${environment}-${instance}'
var dataAppInsightsName = 'appi-${workloadName}-data-api-${environment}-${instance}'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: logAnalyticsName
  location: location
  tags: tags

  properties: {
    sku: {
      name: 'PerGB2018'
    }

    retentionInDays: retentionInDays

    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }

    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'

    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource authAppInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: authAppInsightsName
  location: location
  tags: tags
  kind: 'web'

  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'

    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource dataAppInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: dataAppInsightsName
  location: location
  tags: tags
  kind: 'web'

  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'

    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output logAnalyticsId string = logAnalytics.id
output logAnalyticsName string = logAnalytics.name

output authAppInsightsId string = authAppInsights.id

@secure()
output authAppInsightsConnectionString string = authAppInsights.properties.ConnectionString

output dataAppInsightsId string = dataAppInsights.id

@secure()
output dataAppInsightsConnectionString string = dataAppInsights.properties.ConnectionString
