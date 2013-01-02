# 2012-12-05

# ruby -Ilib -rstella scripts/redis/mathplay.rb

# http://redis.io/commands/eval
# http://tryr.codeschool.com/levels/6/challenges/1
# http://lua-users.org/wiki/UnitConversion
# http://lua-users.org/wiki/SimpleStats
# http://lua-users.org/wiki/TablesTutorial
# - cjson.decode(), cjson.encode()

now = Time.at(1354737856)

begin
  Stella.load!
  r = Stella.redis

  # TODO:
  # - Host#rangemetrics, #Customer#rangemetrics
  # - Puts metrics into a redis database other than 0.
  # - Round sdev and avg
  # - bin/stella command to populate rangemetrics

  customers = Stella::Customer.all #first :email => 'delano@blamestella.com'
  customers.each do |cust|
    hosts = cust.hosts(:hidden => false, :monitored => true)

    # Iterate through all testruns in all testplans for this customer's hosts.
    hosts.each do |host|
      puts '%s: %d testplans' % [host.hostname, host.testplans.size]
      end_time = Stella.now.to_i
      host.testplans.each do |plan|
        puts ' %3d testruns' % [plan.testruns.size]
        plan.testruns(:created_at.gt => Stella.now-24.hours).each do |run|
          next if ! run.metrics?
          plan.add_metrics run.started_at, run.metrics
          host.add_metrics run.started_at, run.metrics
          end_time = run.started_at
        end
        # If at least one testrun was processed
        if end_time
          keys = [plan.rangemetrics.metrics.key]
          Stella::RangeMetrics.ranges.each_pair do |rangeid,duration|  # [past_1h, 1hour]
            argv = [end_time.to_i, duration, plan.rangemetrics.send(rangeid).key]
            cnt = r.evalsha(Stella.redis_scripts['metrics_calculator'], keys, argv)
            puts '  %d items for %s (%s)' % [cnt, rangeid, plan.rangemetrics.metrics.key]
          end
        end
      end

      keys = [host.rangemetrics.metrics.key]
      Stella::RangeMetrics.ranges.each_pair do |rangeid,duration|  # [past_1h, 1hour]
        argv = [end_time.to_i, duration, host.rangemetrics.send(rangeid).key]
        cnt = r.evalsha(Stella.redis_scripts['metrics_calculator'], keys, argv)
        puts '  %d items for %s (%s)' % [cnt, rangeid, host.rangemetrics.metrics.key]
      end

    end
  end




rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end
