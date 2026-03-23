import { openDB } from "idb";
import type { IDBPDatabase, DBSchema as IDBSchema } from "idb";

import type { DatabaseInfo } from "./types.js";

const DATABASES_DB = "stratasync_databases";
const DATABASES_STORE = "databases";

interface DatabasesSchema extends IDBSchema {
  databases: {
    key: string;
    value: DatabaseInfo;
  };
}

export class DatabaseManager {
  private db: IDBPDatabase<DatabasesSchema> | null = null;
  private openPromise: Promise<void> | null = null;

  async open(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.openPromise) {
      await this.openPromise;
      return;
    }

    this.openPromise = (async () => {
      this.db = await openDB<DatabasesSchema>(DATABASES_DB, 1, {
        upgrade: (database) => {
          if (!database.objectStoreNames.contains(DATABASES_STORE)) {
            database.createObjectStore(DATABASES_STORE, { keyPath: "name" });
          }
        },
      });
    })();

    try {
      await this.openPromise;
    } finally {
      this.openPromise = null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.openPromise = null;
  }

  async getDatabaseInfo(name: string): Promise<DatabaseInfo | null> {
    const db = this.ensureOpen();
    const info = await db.get(DATABASES_STORE, name);
    return (info as DatabaseInfo | undefined) ?? null;
  }

  async saveDatabase(info: DatabaseInfo): Promise<void> {
    const db = this.ensureOpen();
    await db.put(DATABASES_STORE, info);
  }

  private ensureOpen(): IDBPDatabase<DatabasesSchema> {
    if (!this.db) {
      throw new Error("Database manager not open. Call open() first.");
    }
    return this.db;
  }
}
