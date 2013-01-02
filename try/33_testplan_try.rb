require 'stella'

#Stella.debug = true
Stella.load! :tryouts

Stella::Testplan.destroy! :planid => '8aafec572811cb1f93978e4a12be5ca5632ff368'
Stella::Testplan.destroy! :planid => 'db8ba3b6d033f47401eff2e3128f28cef4366785'
Stella::Host.destroy! :hostid => '33stellaaahhhh.com'

@cust = Stella::Customer.first_or_create :custid => :tryouts33, :email => 'tryouts33@blamestella.com'
@host = Stella::Host.first_or_create :customer => @cust, :hostid => '33stellaaahhhh.com'

## Create
begin
  @plan1 = Stella::Testplan.create :host => @host, :customer => @cust
  @plan1.planid
rescue DataMapper::PersistenceError => ex
  puts ex.message, ex.resource
  ex.resource.errors.each { |e| puts e }
  nil
end
#=> '8aafec572811cb1f93978e4a12be5ca5632ff368'

## Definition defaults to an empty Hash
plan = Stella::Testplan.new 
plan.definition
#=> {}

## Add definition as a hash
@plan2 = Stella::Testplan.new :host => @host
@plan2.definition = {
  'requests' => [
    {
      'uri' => ''
    }
  ]
}
@plan2.save
@plan2.definition
#=> {'requests'=>[{'uri'=>''}]}

## Generated digest is constant
[@plan2.planid, @plan2.gibbler]
#=> ['db8ba3b6d033f47401eff2e3128f28cef4366785', 'db8ba3b6d033f47401eff2e3128f28cef4366785']

## Add uri to testplan
plan = Stella::Testplan.new :host => @host, :uri => 'http://solutious.com/'
plan.requests.first
#=> Addressable::URI.parse('http://solutious.com')

@plan1.destroy if @plan1
@plan2.destroy if @plan2
@host.destroy