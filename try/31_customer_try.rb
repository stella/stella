require 'stella'

Stella.debug = true
Stella.load! :tryouts

@custid = rand.gibbler.short
@password = rand.gibbler.shorten(10)

## Customer doesn't exist 
Stella::Customer.exists? "#{@custid}@blamestella.com"
#=> false

## Can instantiate customer
@cust = Stella::Customer.new :custid => @custid, :email => "#{@custid}@blamestella.com"
@cust.custid
#=> @custid

## Knows when it's been saved
@cust.saved?
#=> false

## Can be saved
@cust.save
#=> true

## Passhash is nil
@cust.passhash
#=> nil

## Can set a password
@cust.update_password @password
@cust.save
#=> true

## Knows the correct password
@cust.password? @password
#=> true

## Knows an incorrect password
@cust.password? 'bogus'
#=> false

## Customer does exist
Stella::Customer.exists? "#{@custid}@blamestella.com"
#=> true

## Customer can be destroyed
@cust.destroy!
#=> true
