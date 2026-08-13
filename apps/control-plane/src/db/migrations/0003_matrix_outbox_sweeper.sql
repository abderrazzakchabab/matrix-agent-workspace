CREATE OR REPLACE FUNCTION pending_matrix_delivery_tenants(p_limit integer DEFAULT 100)
RETURNS TABLE(user_id text, workspace_id text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT r.owner_id, o.workspace_id
    FROM outbox_messages o
    JOIN runs r ON r.id = o.aggregate_key
   WHERE o.status = 'pending'
     AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
   GROUP BY r.owner_id, o.workspace_id
   ORDER BY min(o.created_at)
   LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION pending_matrix_delivery_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_matrix_delivery_tenants(integer) TO matrix_app;
