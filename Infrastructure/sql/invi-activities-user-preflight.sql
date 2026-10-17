-- READ ONLY. Run on the production Core DB before considering the write script.
SELECT DATABASE() AS database_name, VERSION() AS mysql_version;
SHOW CREATE TABLE UserTable;
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable'
ORDER BY ORDINAL_POSITION;

-- The system identity is deliberately distinct from the four human sign-in
-- providers. The user-create script refuses to insert until the controlled
-- Provider enum migration has enabled System.
SELECT COLUMN_TYPE AS provider_column_type,
       (COLUMN_TYPE LIKE '%''System''%') AS provider_system_enabled
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider';

-- Exactly zero rows means a new identity is needed. Exactly one safe row may be reused.
-- Any other result is a STOP: do not create a second identity or change an existing person.
SELECT UserId, DisplayName, Provider,
       (Password IS NOT NULL) AS has_password,
       (Email IS NOT NULL) AS has_email,
       (PhoneNumber IS NOT NULL) AS has_phone,
       (ExternalId IS NOT NULL) AS has_external_id,
       isActive, isSuspended, isAdmin, isVerified,
       (DeletedAt IS NOT NULL) AS is_deleted
FROM UserTable
WHERE DisplayName = 'Invi Activities'
ORDER BY UserId;
