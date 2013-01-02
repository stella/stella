require 'stella'

#Stella.debug = true
Stella.load! :tryouts

Stella::Checkup.destroy! :checkid => 'tryoutscheckup'
Stella::Testrun.destroy! :runid => 'checkuprun1'
Stella::Testrun.destroy! :runid => 'checkuprun2'
Stella::Testplan.destroy! :planid => 'checkupplan1'
Stella::Testplan.destroy! :planid => 'checkupplan2'

@cust = Stella::Customer.first_or_create :custid => :tryouts35, :email => 'tryouts35@blamestella.com'
@host = Stella::Host.first_or_create :customer => @cust, :hostname => 'stellaaahhhh.com'
@plan1 = Stella::Testplan.create :planid => 'checkupplan1', :host => @host
@plan2 = Stella::Testplan.create :planid => 'checkupplan2', :host => @host
@run1 = Stella::Testrun.new :runid => 'checkuprun1', :testplan => @plan1
@run2 = Stella::Testrun.new :runid => 'checkuprun2', :testplan => @plan2

## Create
check = Stella::Checkup.new :checkid => 'tryoutscheckup', :customer => @cust, :host => @host
check.planid = @plan1.planid
check.runid = @run1.runid
begin
  check.save
rescue DataMapper::PersistenceError => ex
  puts ex.message, ex.resource
  ex.resource.errors.each { |e| puts e }
  nil
end
#=> true

## Has planids
check = Stella::Checkup.first :checkid => 'tryoutscheckup'
check.planid
#=> 'checkupplan1'

## Has runids
check = Stella::Checkup.first :checkid => 'tryoutscheckup'
check.runid
> #=> 'checkuprun1'

## Can change status
check = Stella::Checkup.first :checkid => 'tryoutscheckup'
check.status = :done
check.save
check = Stella::Checkup.first :checkid => 'tryoutscheckup'
check.status
#=> :done

@plan1.destroy! if @plan1