-- REDIS SCRIPT - METRICS CALCULATOR
-- delano (2012-12-17)
--
-- Takes a range of JSON objects from a sortedset and calculates
-- the sum, average (mean), max, min, and standard devaiation
-- key with numeric values.
--
-- Usage:
--    r.eval(SCRIPT, [SORTEDSETKEY], [END_TIME (s), DURATION (s), HASHKEY])
--
-- Returns:
--    # of JSON object
--
local etime, stime, target = ARGV[1], ARGV[1]-ARGV[2], ARGV[3]
redis.log(redis.LOG_NOTICE, KEYS[1] .. ' ' .. etime .. ' ' .. stime .. ' ' .. target)

local items = redis.call('zrangebyscore', KEYS[1], stime, etime)

if #items == 0 then
  return { err = 'The key "'..KEYS[1]..'" contains no metrics' }
end

local stats = {}

for i=1,#items do
  local metrics = cjson.decode(items[i])

  -- See: http://lua-users.org/wiki/SimpleStats
  -- avg and sdv taken from Benelux::Stats::Calculator
  for k,v in pairs(metrics) do
    if type(v) == 'number' then
      local max, min, sum, cnt = k..'_max', k..'_min', k..'_sum', k..'_cnt'
      local ssq, sdv, avg      = k..'_ssq', k..'_sdv', k..'_avg'
      if stats[cnt] == nil then
        stats[max] =  -math.huge
        stats[min] =  math.huge
        stats[sum] =  0
        stats[ssq] =  0
        stats[cnt] =  0
        stats[sdv] =  0
        stats[avg] =  0
      end
      stats[sum] = stats[sum] + v
      stats[cnt] = stats[cnt] + 1
      stats[ssq] = stats[ssq] + v * v
      stats[avg] = stats[sum] / stats[cnt]
      stats[max] = math.max( stats[max], v )
      stats[min] = math.min( stats[min], v )
      stats[sdv] = math.sqrt( (stats[ssq] - (stats[sum]*stats[sum]/stats[cnt])) / (stats[cnt]-1) )
    end
  end

end

-- TODO: Figure out why redis.call('hmset', target, unpack(stats)) doesn't work
for k,v in pairs(stats) do
  redis.call('hset', target, k, v)
end

return #items;
