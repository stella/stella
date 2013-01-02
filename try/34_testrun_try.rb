require 'stella'

#Stella.debug = true
Stella.load! :tryouts

Stella::Testrun.destroy! :runid => 'tryoutsrun34'
Stella::Testplan.destroy! :planid => 'tryoutsplan34'

@cust = Stella::Customer.first_or_create :custid => :tryouts_34, :email => 'tryouts34@blamestella.com'
@host = Stella::Host.first_or_create :customer => @cust, :hostname => '34stellaaahhhh.com'
@plan = Stella::Testplan.create :planid => 'tryoutsplan34', :definition => { :tryouts => true }, :host => @host

## Create
run = Stella::Testrun.new :runid => 'tryoutsrun34', :testplan => @plan, :customer => @cust, :host => @host
run.data = {
  'concurrency' => 2,
  'repetitions' => 1,
  'anyoloption' => 'textual'
}
begin
  run.save
rescue DataMapper::PersistenceError => ex
  puts ex.message, ex.resource
  ex.resource.errors.each { |e| puts e }
  nil
end
#=> true

## Can change status
run = Stella::Testrun.first :runid => 'tryoutsrun34'
run.status = :done
run.save
run = Stella::Testrun.first :runid => 'tryoutsrun34'
run.status
#=> :done

## Can't change to unknown status
run = Stella::Testrun.first :runid => 'tryoutsrun34'
run.status = :poop
begin
  run.save
rescue DataMapper::SaveFailureError => ex
  :success
end
#=> :success

## Find
run = Stella::Testrun.first :runid => 'tryoutsrun34'
[run.data['concurrency'], run.data['repetitions'], run.data['anyoloption']]
#=> [2, 1, 'textual']

## Find w/ testplan
run = Stella::Testrun.first :runid => 'tryoutsrun34'
run.testplan.saved?
#=> true

## Delete
run = Stella::Testrun.first :runid => 'tryoutsrun34'
run.destroy
#=> true

## runids are always unique
runs = []
1000.times { run = Stella::Testrun.new(:customer => @cust); run.normalize; runs << run }
runs.collect(&:runid).uniq.size
#=> 1000

@plan.destroy!
@host.destroy!
@cust.destroy!