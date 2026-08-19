use tauri_plugin_sql::{Migration, MigrationKind};

/// Returns all database migrations
pub fn migrations() -> Vec<Migration> {
    vec![
        // Migration 1: Create system_prompts table with indexes and triggers
        Migration {
            version: 1,
            description: "create_system_prompts_table",
            sql: include_str!("migrations/system-prompts.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 2: Create chat history tables (conversations and messages)
        Migration {
            version: 2,
            description: "create_chat_history_tables",
            sql: include_str!("migrations/chat-history.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_versions_are_unique_and_ascending() {
        let migrations = migrations();
        let versions: Vec<i64> = migrations.iter().map(|m| m.version).collect();

        let mut sorted = versions.clone();
        sorted.sort_unstable();
        sorted.dedup();

        assert_eq!(
            versions, sorted,
            "migration versions must be unique and ascending, or the plugin \
             will skip or re-run migrations on upgrade"
        );
    }

    #[test]
    fn every_migration_carries_sql_and_a_description() {
        for migration in migrations() {
            assert!(
                !migration.description.trim().is_empty(),
                "migration {} has no description",
                migration.version
            );
            assert!(
                !migration.sql.trim().is_empty(),
                "migration {} has empty sql, so include_str! is pointed at the \
                 wrong file",
                migration.version
            );
        }
    }

    #[test]
    fn chat_history_migration_keeps_the_attached_files_column() {
        let chat_history = migrations()
            .into_iter()
            .find(|m| m.description == "create_chat_history_tables")
            .expect("chat history migration is missing");

        assert!(
            chat_history.sql.contains("attached_files"),
            "the messages table must keep attached_files: the completion hook \
             persists screenshots into it, and dropping the column loses them \
             silently"
        );
        assert!(chat_history.sql.contains("conversations"));
        assert!(chat_history.sql.contains("messages"));
    }

    #[test]
    fn system_prompts_migration_creates_its_table() {
        let prompts = migrations()
            .into_iter()
            .find(|m| m.description == "create_system_prompts_table")
            .expect("system prompts migration is missing");

        assert!(prompts.sql.contains("system_prompts"));
    }
}
