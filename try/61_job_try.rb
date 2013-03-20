require 'stella'
#Stella.debug = true

Stella.load! :tryouts

#Stella::Host.destroy! :hostname => 'bff.heroku.com'
#Stella::Customer.destroy! :email => 'tryouts61@blamestella.com'
@cust = Stella::Customer.first_or_create :email => 'tryouts61@blamestella.com'
@host = Stella::Host.first_or_create :hostname => 'bff.heroku.com', :custid => @cust.custid, :customer => @cust
@host.customer = @cust and @host.save

## Can generate unique ID
sid = Stella::Job.generate_id :poop
[sid.class, sid.size]
#=> [Gibbler, 40]

## Job db
Stella::Job.db
#=> 11

## Can instantiate
s = Stella::Job.new 'someid'
[s.class, s.objid]
#=> [Stella::Job, 'someid']

## Can create
s = Stella::Job.create :name => 'value'
p s.objid
[s.class, s.objid.size, s[:name]]
#=> [Stella::Job, 40, 'value']

## Knows classes
Stella::Queueable.classes.collect(&:to_s)
#=> ["Stella::Job::SendEmail", "Stella::Job::SendSMS", "Stella::Job::RenderHost", "Stella::Job::RenderPlan", "Stella::Job::Checkup", "Stella::Job::Testrun", "Stella::Job::TestrunRemote"]

## Enqueing defaults to high queue
job = Stella::Job::RenderHost.enqueue
[job.queue.key, job[:queue_key], job.queue.class]
#=> ["v3:queue:high", "v3:queue:high", Stella::SmartQueue]

## Jobs can take data
job = Stella::Job::RenderHost.enqueue :hostid => 'tryouts66'
job[:hostid]
#=> 'tryouts66'

## Jobs know their class
job = Stella::Job::RenderHost.enqueue :hostid => @host.hostid
[job[:type], job.type]
#=> ["Stella::Job::RenderHost", Stella::Job::RenderHost]

## Jobs run (SMS)
job = Stella::Job::SendSMS.enqueue :phone => Stella.config['account.tech.phone'], :message => "Job test #{Stella.now}"
job.perform.class
#=> HTTParty::Response

## Jobs run (Email)
job = Stella::Job::SendEmail.enqueue :email => Stella.config['account.tech.email'], :subject => "Job test #{Stella.now}", :content => @cust.email
job.perform.class
#=> SendGrid

@host.destroy if @host
@cust.destroy if @cust
