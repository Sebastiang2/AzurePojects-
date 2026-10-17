-- CONTROLLED SCHEMA CHANGE. Run only after invi-activities-user-preflight.sql.
--
-- Production currently uses the exact baseline enum below. Existing values all
-- represent human sign-in methods, so this migration adds a separate System value
-- rather than assigning the system identity a misleading provider.
--
-- MySQL DDL commits implicitly. Review provider_system_enabled = 1 before running
-- invi-activities-user-create.sql. If this script reports STOP, do not continue.

SET @provider_baseline_type = 'enum(''CetchApp'',''Snapchat'',''Google'',''Apple'')';
SET @provider_system_type = 'enum(''CetchApp'',''Snapchat'',''Google'',''Apple'',''System'')';
SET @provider_column_type = (
  SELECT COLUMN_TYPE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider'
);

SET @provider_migration_sql = CASE
  WHEN @provider_column_type = @provider_baseline_type
    THEN 'ALTER TABLE `UserTable` MODIFY COLUMN `Provider` ENUM(''CetchApp'', ''Snapchat'', ''Google'', ''Apple'', ''System'') NULL DEFAULT NULL'
  WHEN @provider_column_type = @provider_system_type
    THEN 'SELECT ''already enabled'' AS provider_system_migration_status'
  ELSE 'SELECT ''STOP: unexpected UserTable.Provider definition; no schema change was made'' AS provider_system_migration_status'
END;

PREPARE provider_migration FROM @provider_migration_sql;
EXECUTE provider_migration;
DEALLOCATE PREPARE provider_migration;

SELECT COLUMN_TYPE AS provider_column_type,
       (COLUMN_TYPE = @provider_system_type) AS provider_system_enabled
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider';
