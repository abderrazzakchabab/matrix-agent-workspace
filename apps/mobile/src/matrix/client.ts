import type { ControlPlaneApi, MatrixSessionResponse } from '../api/control-plane';

export interface MatrixCredentials {
  homeserverUrl: string;
  accessToken: string;
}

/**
 * Establishes Matrix identity through the control plane. The access token is
 * used only for this request and is never retained by the mobile client.
 */
export function createMatrixClient(controlPlane: ControlPlaneApi) {
  return {
    login(credentials: MatrixCredentials): Promise<MatrixSessionResponse> {
      return controlPlane.createMatrixSession(
        credentials.homeserverUrl.trim(),
        credentials.accessToken,
      );
    },
  };
}

export type MatrixClient = ReturnType<typeof createMatrixClient>;
