# Bootstrap is done via REST (NDJSON streaming) for better performance

# This file documents the expected request/response format

# GET /sync/bootstrap?type=full&onlyModels=User,Task&schemaHash=abc123

# Query params:

# - type=full|partial

# - onlyModels=Comma-separated model names (optional)

# - schemaHash=Schema hash for validation/caching (optional)

# - firstSyncId/syncGroups/... (optional for partial bootstrap)

# Response: NDJSON stream

# Lines 1..N-1 (data rows):

# {"\_\_class": "User", "id": "...", "name": "..."}

# {"\_\_class": "Task", "id": "...", "title": "..."}

# Last line (metadata):

# {"lastSyncId": "500", "subscribedSyncGroups": ["group-id-1"], "returnedModelsCount": {"User": 1, "Task": 1}, "schemaHash": "abc123"}

# OR:

# _metadata_={"lastSyncId":"500","subscribedSyncGroups":["group-id-1"],"returnedModelsCount":{"User":1,"Task":1}}
