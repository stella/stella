require 'stella'
require 'stella/worker'

Stella.load! :tryouts
Stella::SmartQueue.nowfixed = Time.at(1354737856)

@now = Time.parse('2012-05-08 23:26:17 UTC')

@worker = Stella::Worker.new
@worker.interval = 3.seconds

## Has a default queue filter
@worker.queue_filter
#=> ["montreal"]

## Knows its queue priority
queues = @worker.queue_priority
queues.collect(&:key)
#=> ["v3:queue:critical:montreal", "v3:queue:critical", "v3:queue:high:montreal", "v3:queue:high", "v3:queue:low:montreal", "v3:queue:low"]

## Knows its notch priority
queues = @worker.notch_priority(@now)
queues.collect(&:key)
#=> ["v3:queue:08d2326:montreal", "v3:queue:08d2325:montreal", "v3:queue:08d2324:montreal"]


## Can get the redis key
queues = @worker.queue_priority.first.key
#=> 'v3:queue:critical:montreal'

## Populate queues (6)
@worker.queue_priority.inject(0) { |incr,q|
  incr += 1
  q.clear
  q.add "q#{incr}"
  incr
}
#=> 6

## Can get a jobids in the correct order of priority
jobs = []
@worker.queue_priority.size.times { jobs << @worker.pop }
jobs
#=> ('q1'..'q6').to_a
