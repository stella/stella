require 'stella'

#Stella.debug = true
Stella.load! :tryouts

@cust = Stella::Customer.first_or_create :custid => 'tryouts27cust', :email => 'tryouts37@blamestella.com'
@now = Time.at(1354737856)

## Can instantiate with consistent digest
m = Stella::RemoteMachine.new :custid => 'tryouts37cust', :hostname => 'tryouts37host', :ipaddress => '127.0.0.1'
m.gibbler
#=> '3efa1dcf3914d3dffef21d01e2cbcfcc69a43aa3'

## Can create
m = Stella::RemoteMachine.first_or_create :custid => 'tryouts37cust', :hostname => 'tryouts37host', :ipaddress => '127.0.0.1', :customer => @cust
m.machineid
#=> '3efa1dcf3914d3dffef21d01e2cbcfcc69a43aa3'

## Can instantiate WorkerProfile
m = Stella::RemoteMachine.first_or_create :custid => 'tryouts37cust', :hostname => 'tryouts37host', :ipaddress => '127.0.0.1', :customer => @cust
w = Stella::WorkerProfile.new :interval => 30, :remote_machine => m, :created_at => @now
w.gibbler
#=> '5a4eba766ca0f2b3163418ba427c2fada8046bbc'

## Can create WorkerProfile
m = Stella::RemoteMachine.first_or_create :custid => 'tryouts37cust', :hostname => 'tryouts37host', :ipaddress => '127.0.0.1', :customer => @cust
w = Stella::WorkerProfile.first_or_create :interval => 30, :remote_machine => m
w.saved?
#=> true


## has a local machine
m = Stella::RemoteMachine.local
[m.ipaddress, m.custid]
#=> ["127.0.0.1", Stella::Customer.anonymous.custid]

@cust.remote_machines.worker_profiles.destroy
@cust.remote_machines.destroy
@cust.destroy!
