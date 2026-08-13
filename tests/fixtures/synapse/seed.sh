#!/bin/sh
# Seed the Synapse fixture with two users and a room. Idempotent: safe to run
# repeatedly against the same homeserver.
set -eu

CONFIG=/data/homeserver.yaml
URL="http://localhost:8008"
PW_ALICE="alice_secret"
PW_BOB="bob_secret"

register_new_matrix_user -u alice --exists-ok -p "$PW_ALICE" --no-admin -c "$CONFIG" "$URL"
register_new_matrix_user -u bob --exists-ok -p "$PW_BOB" --no-admin -c "$CONFIG" "$URL"

ALICE_TOKEN=$(curl -fsS -X POST "$URL/_matrix/client/v3/login" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"alice\"},\"password\":\"$PW_ALICE\"}" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')

# Resolve a stable room alias first so repeated fixture starts reuse the same
# authorized room instead of accumulating random room IDs.
ALIAS_ENCODED='%23alice%3Aexample.test'
LOOKUP_FILE=/tmp/matrix-alice-room.json
LOOKUP_STATUS=$(curl -sS -o "$LOOKUP_FILE" -w '%{http_code}' \
  "$URL/_matrix/client/v3/directory/room/$ALIAS_ENCODED")
if [ "$LOOKUP_STATUS" = "200" ]; then
  ROOM_ID=$(python3 -c 'import sys, json; print(json.load(sys.stdin)["room_id"])' < "$LOOKUP_FILE")
else
  ROOM_ID=$(curl -fsS -X POST "$URL/_matrix/client/v3/createRoom" \
    -H "Authorization: Bearer $ALICE_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"name":"Alice Room","preset":"private_chat","room_alias_name":"alice"}' \
    | python3 -c 'import sys, json; print(json.load(sys.stdin)["room_id"])')
fi

echo "seeded @alice:example.test and $ROOM_ID (#alice:example.test)"
