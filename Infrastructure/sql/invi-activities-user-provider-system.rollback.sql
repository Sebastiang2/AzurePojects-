-- CONTROLLED ROLLBACK for invi-activities-user-provider-system.sql.
--
-- MySQL DDL commits implicitly. This script removes System only when no UserTable
-- row uses it (any row, including soft-deleted ones) and no Invi Activities identity
-- exists, so it can restore the original schema after a rejected or rolled-back
-- user-create transaction. It never removes System from a database where the
-- dedicated identity was committed.
--
-- Removing an enum member needs a table rebuild, so the ALTER uses ALGORITHM=COPY
-- with LOCK=SHARED: writers are blocked while it runs, so no System row can appear
-- between the check and the change. Strict mode makes the server reject the ALTER
-- if a row still holds the removed value instead of silently blanking it.
-- The column keeps its current character set, collation, nullability, default and
-- comment: they are read from information_schema and re-applied, never guessed.

SET SESSION sql_mode = IF(@@SESSION.sql_mode = '', 'STRICT_ALL_TABLES', CONCAT(@@SESSION.sql_mode, ',STRICT_ALL_TABLES'));

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
SET @system_provider_user_count = (
  SELECT COUNT(*) FROM UserTable WHERE Provider = 'System'
);
SET @invi_activities_count = (
  SELECT COUNT(*) FROM UserTable WHERE DisplayName = 'Invi Activities'
);

SET @provider_rollback_sql = CASE
  WHEN @provider_column_type = @provider_system_type
       AND @system_provider_user_count = 0 AND @invi_activities_count = 0
       AND @provider_attributes IS NOT NULL
    THEN CONCAT(
      'ALTER TABLE `UserTable` MODIFY COLUMN `Provider` ENUM(''CetchApp'', ''Snapchat'', ''Google'', ''Apple'')',
      @provider_attributes,
      ', ALGORITHM=COPY, LOCK=SHARED')
  WHEN @provider_column_type = @provider_baseline_type
    THEN 'SELECT ''already at baseline'' AS provider_system_rollback_status'
  ELSE 'SELECT ''STOP: System cannot be removed while a user row uses it or Invi Activities exists, or the Provider definition is unexpected'' AS provider_system_rollback_status'
END;

PREPARE provider_rollback FROM @provider_rollback_sql;
EXECUTE provider_rollback;
DEALLOCATE PREPARE provider_rollback;

SELECT COLUMN_TYPE AS provider_column_type,
       @system_provider_user_count AS system_provider_user_count,
       @invi_activities_count AS invi_activities_count,
       (COLUMN_TYPE = @provider_baseline_type) AS provider_baseline_restored,
       IS_NULLABLE AS provider_is_nullable,
       CHARACTER_SET_NAME AS provider_character_set,
       COLLATION_NAME AS provider_collation
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserTable' AND COLUMN_NAME = 'Provider';
