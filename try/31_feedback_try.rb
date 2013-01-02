require 'stella'

Stella.debug = true
Stella.load! :tryouts

@custid = rand.gibbler.short
@cust = Stella::Customer.create :custid => @custid, :email => "#{@custid}@blamestella.com", :testing => true

## Customer exists
@cust.saved?
#=> true

## Can create feedback
res = @cust.create_feedback "#{__FILE__} @ #{Stella.now}"
res.saved?
#=> true

## Cound feedback
@cust.feedbacks.count
#=> 1
