/** Column names and row shape for the `rooms` and `room_bindings` tables. */
export const ROOMS = {
  table: 'rooms',
  roomId: 'room_id',
  homeserverUrl: 'homeserver_url',
  displayName: 'display_name',
  createdAt: 'created_at',
} as const;

export const ROOM_BINDINGS = {
  table: 'room_bindings',
  roomId: 'room_id',
  homeserverUrl: 'homeserver_url',
  workspaceId: 'workspace_id',
  userId: 'user_id',
  verifiedAt: 'verified_at',
  createdAt: 'created_at',
} as const;

export interface RoomRow {
  roomId: string;
  homeserverUrl: string;
  displayName: string | null;
}

export interface RoomBindingRow {
  roomId: string;
  homeserverUrl: string;
  workspaceId: string;
  userId: string;
  verifiedAt: string;
}
