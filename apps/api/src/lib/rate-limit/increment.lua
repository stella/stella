-- Atomic INCR + conditional EXPIRE for rate limiting.
-- Avoids the race where a crash between INCR and EXPIRE
-- leaves a key with no TTL (persisting forever).
--
-- KEYS[1]: the rate-limit key
-- ARGV[1]: TTL in seconds

local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return { count, redis.call("TTL", KEYS[1]) }
