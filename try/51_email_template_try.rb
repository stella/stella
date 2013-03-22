$: << './app'
require 'stella'
require 'stella/app/helpers'
require 'stella/app/web/base'
require 'stella/app/web/views'
require 'stella/email'

Stella.debug = false
Stella.load! :tryouts

@cust = Stella::Customer.first_or_create :email => 'tryouts51-%s@blamestella.com' % [(rand*1000).to_i], :testing => true

## hihi
Stella::App::StaticHelpers.uri :checkup, '1'
#=> 'http://www.bs.com:3000/checkup/1'

## Express Confirmation
uri = 'https://tryouts51.com/account/claim/abc123'
args = [@cust, :hostname => 'tryouts51.com', :uri => uri]
view = Stella::Email::Account::ExpressConfirmation.new *args
view.render.match(uri).nil?
##=> false

## General notification
uri = 'https://tryouts51.com/account/claim/abc123'
args = [@cust, :hostname => 'tryouts51.com', :runid => '1234567890abcdef']
view = Stella::Email::Notification::General.new *args
puts view.render
view.render.match(uri).nil?
#=> false

## Send Email
uri = 'https://tryouts51.com/account/claim/abc123'
args = [@cust, :hostname => 'tryouts51.com', :runid => '1234567890abcdef']
view = Stella::Email::Notification::General.new *args
ret = view.send_email
ret.response.code
#=> 200

@cust.destroy!
