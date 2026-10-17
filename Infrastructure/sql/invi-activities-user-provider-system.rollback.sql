-- CONTROLLED ROLLBACK for invi-activities-user-provider-system.sql.
--
-- MySQL DDL commits implicitly. This script removes System only when no Invi
-- Activities identity exists, so it can restore the original schema after a
-- rejected or rolled-back user-create transaction. It never removes System from a
-- database where the dedicated identity was committed.

SET @provider_baseline_type = 'enum(''CetchApp'',''Snapchat'',''Google'',''Apple'')';
SET @provider_system_type = 'enum(''CetchApp'',''Snapchat'',''Google'',''Apple'',''System'')';
SET @provider_column_type = (
  SELECT COLUMN_TYPE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider'
);
SET @invi_activities_count = (
  SELECT COUNT(*) FROM UserTable WHERE DisplayName = 'Invi Activities'
);

SET @provider_rollback_sql = CASE
  WHEN @provider_column_type = @provider_system_type AND @invi_activities_count = 0
    THEN 'ALTER TABLE `UserTable` MODIFY COLUMN `Provider` ENUM(''CetchApp'', ''Snapchat'', ''Google'', ''Apple'') NULL DEFAULT NULL'
  WHEN @provider_column_type = @provider_baseline_type
    THEN 'SELECT ''already at baseline'' AS provider_system_rollback_status'
  ELSE 'SELECT ''STOP: System cannot be removed while Invi Activities exists, or the Provider definition is unexpected'' AS provider_system_rollback_status'
END;

PREPARE provider_rollback FROM @provider_rollback_sql;
EXECUTE provider_rollback;
DEALLOCATE PREPARE provider_rollback;

SELECT COLUMN_TYPE AS provider_column_type,
       @invi_activities_count AS invi_activities_count,
       (COLUMN_TYPE = @provider_baseline_type) AS provider_baseline_restored
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider';
