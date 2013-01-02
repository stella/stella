require 'stella'

Stella.debug = false
#Gibbler.debug = true
Stella.load! :tryouts

@sess = Stella::Session.create '127.0.0.1', 'user agent'
@cust = Stella::Customer.first_or_create :custid => :tryouts45, :email => 'tryouts45@blamestella.com'
@params = { :uri => 'http://solutious.com/' }

## Create instance
Stella::Logic.safedb do
  logic = Stella::Logic::CreateCheckup.new(@sess, @cust, @params)
  logic.raise_concerns(:create_checkup)
  logic.create
  logic.checkup.saved?
end
#logic.queue_jobs
#res.redirect '/checkup/%s' % [logic.checkup.checkid]
#false
#=> true
