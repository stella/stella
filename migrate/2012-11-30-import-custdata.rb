# 2012-11-30
# * Import customer dump from BS2

# ruby -Ilib -rstella migrate/2012-11-30-import-custdata.rb < custdata.json

# NOTE: This script assumes all data is in the json file

# Nov 30 @ 13:00:

#Stella.debug = true
require 'pp'

begin
  Stella.load!

  customers = []
  Yajl::Parser.parse(STDIN) do |e|
    customers << e
  end
  Stella.li "Found #{customers.size} entries"

  cust_count = {:created=>0,:saved=>0}
  host_count = {:created=>0,:saved=>0}
  skip_count = 0
  plan_count = {:created=>0,:saved=>0}
  customers.each do |oldcust|
    next if oldcust['email'].to_s.empty?
    #next if oldcust['custid'] != 'delano'
    cust = Stella::Customer.first :email => oldcust['email']
    if cust.nil?
      cust = Stella::Customer.new :email => oldcust['email']
      cust_count[:created] += 1
    end
    cust.nickname = oldcust['custid']
    cust.name = [oldcust['fname'], oldcust['lname']].join(' ').strip
    cust.email = oldcust['email']
    cust.website = oldcust['website']
    cust.company = oldcust['company']
    cust.location = oldcust['location']
    cust.created_at = Time.at(oldcust['created'])
    cust.updated_at = Time.at(oldcust['updated'])
    cust.role = oldcust['role']
    if oldcust['passhashv'] == 3
      cust.passhash = oldcust['passhash']
      cust.password_at = Time.at(oldcust['changedpassword'])
    else
      cust.passhash = nil
      cust.password_at = nil
    end
    cust.passhashv = oldcust['passhashv']
    cust.comped = oldcust['comp'].to_s == 'true'
    cust.legacy = oldcust

    prodid, highlight = nil, false
    # Customers from 2012-11-22 who were emailed previously have
    # already been tagged with a migration profile. We can grab that.
    if oldcust['vars']['migrated']
      case oldcust['vars']['migration_profile']
      when 'free_active'
        prodid = :site_free_v1
      when 'free_inactive'
        skip_count += 1
      when 'comped'
        prodid = :site_basic_v1
        highlight = true
        cust.comped = true
      when 'lifetime'
        prodid = :site_basic_v1
        cust.comped = true
        highlight = true
      when 'paid_active'
        highlight = true
        prodid = :site_basic_v1
      when 'paid_previously'
        prodid = :site_free_v1
      when 'paid_inactive'
        prodid = :site_free_v1
      when 'noemail'
        skip_count += 1
      else
        p [:WHOA, oldcust['custid'], oldcust['vars']]
      end

      cust.migration_profile = oldcust['vars']['migration_profile']
    else
      cust.migration_profile = "free_december"
      prodid = cust.comped ? :site_basic_v1 : :site_free_v1
    end

    #
    #puts '%16s %12s %16s %6s %16s%s' % [cust.nickname, oldcust['prodid'], cust.migration_profile, cust.comped, prodid, suffix]

    Stella::Logic.safedb do
      cust.save
      cust_count[:saved] += 1
    end

    suffix = highlight ? '*' : ''
    unless ['free_inactive'].member?(cust.migration_profile)
      puts '%-16s %16s %6s %12s/%-16s%s' % [cust.nickname, cust.migration_profile, cust.comped, oldcust['prodid'], prodid, suffix]
    end

    oldcust['monitors'].each_pair do |planid,mon|
      host = Stella::Host.first(:hostname => mon['hostid'], :custid => cust.custid)
      if host.nil?
        host_count[:created] += 1
        host = Stella::Host.new(:hostname => mon['hostid'], :custid => cust.custid)
        host.customer = cust
      end
      Stella::Logic.safedb do
        host.save
        host_count[:saved] += 1
      end
      next if mon['uri'].to_s.empty?
      plan = Stella::Testplan.first :custid => cust.custid, :uri => mon['uri']
      if plan.nil?
        plan = Stella::Testplan.new :custid => cust.custid, :host => host, :uri => mon['uri']
        plan_count[:created] += 1
      end
      plan.customer = cust
      plan.enabled = mon['enabled'].to_s == 'true'
      puts '  %s%s' % [mon['enabled'].to_s == 'true' ? '*' : '', plan.uri]
      Stella::Logic.safedb do
        plan.save
        plan_count[:saved] += 1
      end
      host.start! prodid if prodid && mon['enabled'].to_s == 'true'
    end

  end

  puts "Custs Created: #{cust_count[:created]}, Saved: #{cust_count[:saved]}"
  puts "Hosts Created: #{host_count[:created]}, Saved: #{host_count[:saved]}"
  puts "Plans Created: #{plan_count[:created]}, Saved: #{plan_count[:saved]}"
  puts "Skipped: #{skip_count}"
  puts "Done."

rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end
