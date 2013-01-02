# NOTE: Assumes the database contains just test-uris.txt.
#
# bin/stella db -R
# ruby -Ilib -rstella try/00_state_tryouts.rb
#
require 'stella'

#Stella.debug = true
Stella.load! :tryouts

@now = Time.parse('2012-05-08 23:36:17 UTC')

## Default timing belt will get all hosts
hosts = Stella::Host.by_timingbelt 1, 1
hosts.size
#=> 13

## When two timingbelts, the 1st will get half hosts
hosts = Stella::Host.by_timingbelt 1, 2
hosts.size
#=> 6

## When two timingbelts, the 2nd will get half hosts plus 1
hosts = Stella::Host.by_timingbelt 2, 2
hosts.size
#=> 7

## No jobs
Stella::Job.count
#=> 0

## Can reliable schedule a host
Stella::Job.redis.flushdb
Stella::SmartQueue.redis.flushdb
hosts = Stella::Host.by_timingbelt 1, 1
ret = Stella::Host.schedule hosts.first, @now
queues = ret.keys.sort { |a,b| a.key <=> b.key }
[Stella::Job.count, ret.size, queues.first.key, queues.last.key]
#=> [13, 12, "v3:queue:08d2343:montreal", "v3:queue:09d0038:montreal"]

## Can reliable schedule all hosts
Stella::Job.redis.flushdb
Stella::SmartQueue.redis.flushdb
hosts = Stella::Host.by_timingbelt 1, 1
ret = Stella::Host.schedule hosts, @now
queues = ret.keys.sort { |a,b| a.key <=> b.key }
[Stella::Job.count, ret.size, queues.first.key, queues.last.key]
#=> [186, 62, "v3:queue:08d2340:montreal", "v3:queue:09d0041:montreal"]

