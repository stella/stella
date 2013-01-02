require 'stella'
#Stella.debug = true

Stella.load! :tryouts
@now = Time.parse('2012-05-08 23:26:17 UTC')

## Queue db
Stella::SmartQueue.db
#=> 10

## Knows classes
Stella::Queueable.classes.collect(&:to_s).sort
#=> ["Stella::Job::Checkup", "Stella::Job::RenderHost", "Stella::Job::RenderPlan", "Stella::Job::Testrun", "Stella::Job::TestrunRemote"]

## Has default lists
Stella::SmartQueue.queues.keys.sort
#=> ["v3:queue:critical", "v3:queue:critical:montreal", "v3:queue:high", "v3:queue:high:montreal", "v3:queue:low", "v3:queue:low:montreal"]

## Can create queue keynames with filters
Stella::SmartQueue.key :tryouts62, :ANYVALUE, :montreal
#=> "v3:queue:tryouts62:anyvalue:montreal"

## Enqueing defaults to high queue
job = Stella::Job::RenderHost.enqueue :hostid => 'bs.tryouts61.com'
[job.queue, job[:queue_key]]
#=> [Stella::SmartQueue.queue(:high), "v3:queue:high"]

## Can create queue keynames
Stella::SmartQueue.key :tryouts62
#=> "v3:queue:tryouts62"

## Can get a queue
Stella::SmartQueue.queue(:tryouts62).key
#=> "v3:queue:tryouts62"

## A queue knows it's parts
Stella::SmartQueue.queue(:tryouts62).parts
#=> ["tryouts62"]

## Can push to a queue
q = Stella::SmartQueue.queue(:tryouts62).add 'abcdef1234567890'
q.list.size
#=> 1

## Has an expiration
Stella::SmartQueue.queue(:tryouts62).list.ttl
#=> 172800

## Can pop from a queue
Stella::SmartQueue.queue(:tryouts62).list.pop
#=> "abcdef1234567890"

## Can clear a queue
q = Stella::SmartQueue.queue(:tryouts62).add 'bogus'
q.list.clear
#=> 1

## Create a stamp from a Time
q = Stella::SmartQueue.stamp @now
#=> '08d2326'

## Create a stamp from an Integer (assumed UTC)
q = Stella::SmartQueue.stamp 1336519577
#=> '08d2326'

## Create a stamp from a Float (assumed UTC)
q = Stella::SmartQueue.stamp 1336519577.0
#=> '08d2326'

## Can create a notch
q = Stella::SmartQueue.notch(@now, :tryouts62).key
#=> "v3:queue:08d2326:tryouts62"

## Can push to a notch
q = Stella::SmartQueue.notch(@now, :tryouts62).add 'abcdef1234567890'
q.list.pop
#=> 'abcdef1234567890'

## Has a dedupe set
q = Stella::SmartQueue.notch(@now, :tryouts62)
q.set.key
#=> 'v3:queue:08d2326:tryouts62:dedupe'



## Class: queue priority
Stella::SmartQueue.queue_priority.collect(&:key)
#=> ["v3:queue:critical", "v3:queue:high", "v3:queue:low"]

## Class: queue priority with filter
Stella::SmartQueue.queue_priority([:CITY]).collect(&:key)
#=> ["v3:queue:critical:city", "v3:queue:critical", "v3:queue:high:city", "v3:queue:high", "v3:queue:low:city", "v3:queue:low"]

## Class: notch priority
Stella::SmartQueue.notch_priority([], @now).collect(&:key)
#=> ["v3:queue:08d2326", "v3:queue:08d2325", "v3:queue:08d2324"]

## Class: notch priority with count
Stella::SmartQueue.notch_priority([], @now, 10).collect(&:key)
#=> ["v3:queue:08d2326", "v3:queue:08d2325", "v3:queue:08d2324", "v3:queue:08d2323", "v3:queue:08d2322", "v3:queue:08d2321", "v3:queue:08d2320", "v3:queue:08d2319", "v3:queue:08d2318", "v3:queue:08d2317"]

## Class: notch priority with filter
Stella::SmartQueue.notch_priority([:CITY], @now).collect(&:key)
#=> ["v3:queue:08d2326:city", "v3:queue:08d2325:city", "v3:queue:08d2324:city"]

## Class: pop
Stella::SmartQueue.queue_priority.each(&:clear)
Stella::SmartQueue.queue_priority[0].add 'CRITICALVALUE1'
Stella::SmartQueue.queue_priority[0].add 'CRITICALVALUE2'
Stella::SmartQueue.queue_priority[1].add 'HIGHVALUE1'
Stella::SmartQueue.queue_priority[1].add 'HIGHVALUE2'
Stella::SmartQueue.queue_priority[2].add 'LOWVALUE1'
Stella::SmartQueue.queue_priority[2].add 'LOWVALUE2'
[Stella::SmartQueue.pop,Stella::SmartQueue.pop,Stella::SmartQueue.pop,Stella::SmartQueue.pop,Stella::SmartQueue.pop]
#=> ["CRITICALVALUE1", "CRITICALVALUE2", "HIGHVALUE1", "HIGHVALUE2", "LOWVALUE1"]

## Class: shift
Stella::SmartQueue.queue_priority.each(&:clear)
Stella::SmartQueue.queue_priority[0].add 'CRITICALVALUE1'
Stella::SmartQueue.queue_priority[0].add 'CRITICALVALUE2'
Stella::SmartQueue.queue_priority[1].add 'HIGHVALUE1'
Stella::SmartQueue.queue_priority[1].add 'HIGHVALUE2'
Stella::SmartQueue.queue_priority[2].add 'LOWVALUE1'
Stella::SmartQueue.queue_priority[2].add 'LOWVALUE2'
[Stella::SmartQueue.shift,Stella::SmartQueue.shift,Stella::SmartQueue.shift,Stella::SmartQueue.shift,Stella::SmartQueue.shift]
#=> ["CRITICALVALUE2", "CRITICALVALUE1", "HIGHVALUE2", "HIGHVALUE1", "LOWVALUE2"]






