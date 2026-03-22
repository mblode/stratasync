import "fake-indexeddb/auto";

export const deleteDatabase = (name: string): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest uses handler properties
    request.onsuccess = () => {
      resolve();
    };
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest uses handler properties
    request.onerror = () => {
      reject(request.error);
    };
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest uses handler properties
    request.onblocked = () => {
      resolve();
    };
  });

export const deleteDatabases = async (names: string[]): Promise<void> => {
  await Promise.all(names.map((name) => deleteDatabase(name)));
};
