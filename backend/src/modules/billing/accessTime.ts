// Calendar months use the preserved package timezone and PostgreSQL clamping.
export const SIMULATION_TIMES = `WITH ready AS MATERIALIZED (SELECT clock_timestamp() AS activation_at)
  SELECT activation_at, CASE WHEN $1::text='calendar_month'
    THEN ((activation_at AT TIME ZONE $3::text)+make_interval(months=>$2::int)) AT TIME ZONE $3::text
    ELSE activation_at + (($2::bigint * CASE $1::text WHEN 'hour' THEN 3600 WHEN 'day' THEN 86400 WHEN 'week' THEN 604800 END) * interval '1 second')
    END AS expires_at FROM ready`;
