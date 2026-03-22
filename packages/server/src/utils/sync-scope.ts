export const resolveRequestedSyncGroups = (
  authorizedGroups: string[],
  requestedGroups?: string[]
): string[] => {
  if (!requestedGroups || requestedGroups.length === 0) {
    return [...authorizedGroups];
  }

  const allowedGroups = new Set(authorizedGroups);
  return requestedGroups.filter((group) => allowedGroups.has(group));
};

export const resolvePublishedDeltaGroups = (
  groupId: string | null | undefined,
  fallbackGroups: string[]
): string[] => {
  if (groupId) {
    return [groupId];
  }

  return [...fallbackGroups];
};

export const dedupeSyncGroups = (groups: string[]): string[] => [
  ...new Set(groups),
];
