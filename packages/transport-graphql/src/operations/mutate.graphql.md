# Mutations are sent as a single GraphQL operation containing aliased fields.

# Each field returns a syncId for that mutation.

#

# Example:

# mutation SyncBatch($taskUpdateInput: TaskUpdateInput!) {

# t0: taskUpdate(id: "task-id", input: $taskUpdateInput) { syncId }

# t1: taskArchive(id: "task-id") { syncId }

# }

#

# The transport uses a mutationBuilder to create these fields per transaction.
