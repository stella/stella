require 'stella'

#Stella.debug = true
Stella.load! :tryouts

@m = Stella::RangeMetrics.new 'CONTEXT', 'METRIC_ID'

## Can take initialize arguments
[@m.class, @m.context, @m.metric_id]
#=> [Stella::RangeMetrics, 'CONTEXT', 'METRIC_ID']

## Has a base key
@m.base_key
#=> "v3:context:metric_id"

## Has sorted set for metrics
[@m.metrics.key, @m.metrics.class, @m.metrics.options[:expiration]]
#=> ["v3:context:metric_id:metrics", Redis::SortedSet, 604800]

## Has hash for past hour
[@m.past_1h.key, @m.past_1h.class, @m.past_1h.options[:expiration]]
#=> ["v3:context:metric_id:past_1h", Redis::HashKey, 604800]

## Has hash for past 4 hours
[@m.past_4h.key, @m.past_4h.class, @m.past_4h.options[:expiration]]
#=> ["v3:context:metric_id:past_4h", Redis::HashKey, 604800]

## Has hash for past 12 hours
[@m.past_12h.key, @m.past_12h.class, @m.past_12h.options[:expiration]]
#=> ["v3:context:metric_id:past_12h", Redis::HashKey, 604800]

## Has lock
[@m.lock.key, @m.lock.class, @m.lock.options[:expiration], @m.lock.options[:timeout]]
#=> ["v3:context:metric_id:lock", Redis::Lock, 30, 0.1]

