using '../modules/studio-web-domain.bicep'

// Deployment D: enable a managed certificate only after deployment C and public DNS validation have completed.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'
param hostName = 'studio.invi.lol'
param tlsMode = 'managed'
