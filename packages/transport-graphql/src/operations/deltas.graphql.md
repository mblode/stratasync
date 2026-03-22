# Catch-up delta fetching (REST)

# GET /sync/deltas?after=123&limit=1000

# Response (JSON):

# {

# "lastSyncId": "456",

# "hasMore": false,

# "actions": [

# {

# "id": "123",

# "modelName": "Task",

# "modelId": "...",

# "action": "U",

# "data": { ... },

# "groups": ["group-id-1"],

# "clientTxId": "...",

# "clientId": "...",

# "createdAt": "2025-01-01T00:00:00Z"

# }

# ]

# }

# Real-time delta streaming (WebSocket/SSE)

# Client subscribe message:

# { "type": "subscribe", "afterSyncId": "123", "groups": ["group-id-1"], "token": "..." }

#

# Server delta message:

# { "lastSyncId": "456", "actions": [ ... ] }
