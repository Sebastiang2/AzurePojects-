-- CONTROLLED SCHEMA CHANGE. Run only after invi-activities-user-preflight.sql.
--
-- Production currently uses the exact baseline enum below. Existing values all
-- represent human sign-in methods, so this migration adds a separate System value
-- rather than assigning the system identity a misleading provider.
--
-- The column keeps its current character set, collation, nullability, default and
-- comment: they are read from information_schema and re-applied, never guessed.
-- System is appended last, so the change is metadata-only (ALGORITHM=INSTANT). If
-- the server cannot do that it fails instead of silently rebuilding UserTable.
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
SET @provider_attributes = (
  SELECT CONCAT(
    ' CHARACTER SET ', CHARACTER_SET_NAME,
    ' COLLATE ', COLLATION_NAME,
    IF(IS_NULLABLE = 'NO', ' NOT NULL', ' NULL'),
    IF(COLUMN_DEFAULT IS NULL,
       IF(IS_NULLABLE = 'YES', ' DEFAULT NULL', ''),
       CONCAT(' DEFAULT ', QUOTE(COLUMN_DEFAULT))),
    IF(COLUMN_COMMENT = '', '', CONCAT(' COMMENT ', QUOTE(COLUMN_COMMENT)))
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider'
);

SET @provider_migration_sql = CASE
  WHEN @provider_column_type = @provider_baseline_type AND @provider_attributes IS NOT NULL
    THEN CONCAT(
      'ALTER TABLE `UserTable` MODIFY COLUMN `Provider` ENUM(''CetchApp'', ''Snapchat'', ''Google'', ''Apple'', ''System'')',
      @provider_attributes,
      ', ALGORITHM=INSTANT')
  WHEN @provider_column_type = @provider_system_type
    THEN 'SELECT ''already enabled'' AS provider_system_migration_status'
  ELSE 'SELECT ''STOP: unexpected UserTable.Provider definition; no schema change was made'' AS provider_system_migration_status'
END;

PREPARE provider_migration FROM @provider_migration_sql;
EXECUTE provider_migration;
DEALLOCATE PREPARE provider_migration;

-- Expect provider_system_enabled = 1 and the same is_nullable, character set and
-- collation that the preflight reported before this change.
SELECT COLUMN_TYPE AS provider_column_type,
       (COLUMN_TYPE = @provider_system_type) AS provider_system_enabled,
       IS_NULLABLE AS provider_is_nullable,
       CHARACTER_SET_NAME AS provider_character_set,
       COLLATION_NAME AS provider_collation
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider';
