$: << './app'
require 'stella'

Stella.debug = false
#Gibbler.debug = true
Stella.load! :tryouts

@sess = Stella::Session.create '127.0.0.1', 'user agent'
@cust = Stella::Customer.first_or_create :custid => :tryouts44, :email => 'tryouts44@blamestella.com'
@cust.update_password 'tryouts'
@cust.save
@params = { :email => 'tryouts44@blamestella.com', :password => 'tryouts'}

## Can log in
Stella::Logic.safedb do
  logic = Stella::Logic::Login.new(@sess, Stella::Customer.anonymous, @params)
  logic.raise_concerns
  logic.process
  [logic.sess.authenticated?, logic.cust.email]
end
#=> [true, 'tryouts44@blamestella.com']

## Raises an exception with bad password
begin
  logic = Stella::Logic::Login.new(@sess, Stella::Customer.anonymous, {:email => 'tryouts44@blamestella.com', :password => 'bogus'})
  logic.raise_concerns
rescue Stella::App::FailedAuthorization => ex
  :success
end
#=> :success


## Raises an exception with bad email
begin
  logic = Stella::Logic::Login.new(@sess, Stella::Customer.anonymous, {:email => 'poop@b.com'})
  logic.raise_concerns
rescue Stella::App::FailedAuthorization => ex
  :success
end
#=> :success
