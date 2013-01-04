require 'stella'

#Stella.debug = true
Stella.load! :tryouts

@custid = rand.gibbler.short
@password = rand.gibbler.shorten(10)

## Customer doesn't exist
Stella::Customer.exists? "#{@custid}@blamestella.com"
#=> false

## Can instantiate customer
@cust = Stella::Customer.new :custid => @custid, :email => "#{@custid}@blamestella.com", :testing => true
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

## Has no contacts by default
@cust.contacts
#=> []

## When using create, will have a default contact
@cust2 = Stella::Customer.create :custid => "#{@custid}2", :email => "#{@custid}2@blamestella.com", :testing => true
@cust2.contact.email
#=> @cust2.email

## When a customer is destroyed it's left in an unusable state.
[@cust.destroy!, @cust.passhash, @cust.deleted_at.nil?]
#=> [true, nil, false]

## When a customer is destroyed it's children are deleted
p @cust2.contacts
[@cust2.destroy!, @cust2.contacts]
#=> [true, []]
