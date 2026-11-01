using '../modules/studio-web-domain.bicep'

// Deployment C: bind the hostname after its TXT ownership proof exists. Does not enable TLS.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'
param hostName = 'studio.invi.lol'
param tlsMode = 'none'
