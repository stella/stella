require 'stella'

#Stella.debug = true
Stella.load! :tryouts

@uri = 'http://32stellaaahhhh.com/'

Stella::Host.destroy!(:hostid => '32stellaaahhhh.com')
Stella::Host.destroy!(:hostid => '32anotherhost.com')
Stella::Customer.destroy!(:email => 'tryouts32a@blamestella.com')
Stella::Customer.destroy!(:email => 'tryouts32b@blamestella.com')
Stella::Customer.destroy!(:email => 'tryouts32c@blamestella.com')

@cust = Stella::Customer.create :custid => 'tryouts32a', :email => 'tryouts32a@blamestella.com'
@cust2 = Stella::Customer.create :custid => 'tryouts32b', :email => 'tryouts32b@blamestella.com'

## Create Host
@host = Stella::Host.create :customer => @cust, :hostname => @uri
@host.save
#=> true

## Host's uri is normalized
@host.hostname
#=> '32stellaaahhhh.com'

## Host knows its Customer
@customer = @host.customer
[@customer.class, @customer.custid]
#=> [Stella::Customer, 'tryouts32a']

## Host has a custid from the customer object
@host.custid
#=> 'tryouts32a'

## Customer has one host
@cust.hosts.size
#=> 1

## Customer has the host too
this_host = @cust.hosts[0]
this_host.id
#=> @host.id

## Customer generates the same gibbler
@cust2 = Stella::Customer.create :custid => :tryouts2, :email => 'tryouts32c@blamestella.com'
@host2 = Stella::Host.create :customer => @cust2, :hostid => '32anotherhost.com'
@host2.gibbler
#=> '7b20b5527af0d447c00245dc934a4ea279e6796d'

## hostids are different for different customers (by custid property)
host1 = Stella::Host.new :hostname => 'host1', :custid => @cust.custid
host2 = Stella::Host.new :hostname => 'host1', :custid => @cust2.custid
[host1.gibbler, host2.gibbler]
#=> ["be4465c9b60b48d2c2e30b7ad8a01fa5df5f3876", "147f965f137c5cfd6f1df29ef0ad19091f290b0f"]

## hostids are different for different customers (by customer property)
host1 = Stella::Host.new :hostname => 'host1'
host2 = Stella::Host.new :hostname => 'host1'
host1.customer, host2.customer = @cust, @cust2
host1.save && host1.destroy!
host2.save && host2.destroy!
[host1.gibbler, host2.gibbler]
#=> ["be4465c9b60b48d2c2e30b7ad8a01fa5df5f3876", "147f965f137c5cfd6f1df29ef0ad19091f290b0f"]

@host.destroy!
@cust.destroy!
@host2.destroy! if @host2
@cust2.destroy! if @cust2
