import { serve } from 'inngest/next';
import { inngest } from '../../../inngest/client';
import { runRequested } from '../../../inngest/functions/run-requested';
import {
  deliverMatrixEvent,
  sweepMatrixOutbox,
} from '../../../inngest/functions/deliver-matrix-event';

/** HTTP boundary used by Inngest Cloud and the deterministic local dev server. */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runRequested, deliverMatrixEvent, sweepMatrixOutbox],
});
