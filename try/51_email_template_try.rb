$: << './app'
require 'stella'
require 'stella/email'

Stella.debug = false
Stella.load! :tryouts

@cust = Stella::Customer.first_or_create :custid => :tryouts91, :email => 'tryouts91@blamestella.com'

## hihi
Stella::App::StaticHelpers.uri :checkup, '1'
#=> 'http://www.bs.com:3000/checkup/1'

## Express Confirmation
uri = 'https://host/account/claim/abc123'
args = [@cust, :hostname => 'tryouts91.com', :uri => uri]
view = Stella::Email::Account::ExpressConfirmation.new *args
view.render.match(uri).nil?
#=> false
