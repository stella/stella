# 2012-12-31
# * Cleanup DB data after importing
#
# ruby -Ilib -rstella migrate/2012-12-31-import-cleanup.rb
#
# NOTE: This script assumes all customer data is in the database
#
# Dec 31 @ 14:00: Disable monitors for free_inactive (RAN)
# Dec 31 @ 16:45: Create screenshots for hosts and testplans (ran in prod)
# Dec 31 @ 18:00: Create screenshots for non-monitored hosts too.

#Stella.debug = true

begin
  Stella.load!

  free_inactive = Stella::Customer.all :migration_profile => 'free_inactive'
  puts 'Disabling monitors for %s customers (free_inactive)' % free_inactive.count
  free_inactive.each do |cust|
    cust.hosts.each do |host|
      Stella.li ' %s [%s]' % [host.hostname, cust.nickname]
      host.stop!
    end
  end

  monitored_hosts = Stella::Host.all :monitored => true
  monitored_hosts.each do |host|
    Stella.li "Enqueing #{host.hostname}"
    Stella::Job::RenderHost.enqueue :hostid => host.hostid
    host.testplans.each do |plan|
      uri = Stella::Utils.uri(plan.uri)
      Stella.li " #{uri.path}"
      Stella::Job::RenderPlan.enqueue :planid => plan.planid
    end
  end

  unmonitored_hosts = Stella::Host.all :monitored => false
  unmonitored_hosts.each do |host|
    Stella.li "Enqueing #{host.hostname}"
    Stella::Job::RenderHost.enqueue :hostid => host.hostid
  end

  Stella.li "Done."

rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end
