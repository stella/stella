# POPULATE DATABASE / REDIS FOR TESTING
# To be run before tryouts.
#
# ruby -Ilib -rstella try/00_state_tryouts.rb
#
# Will not run if site.env is prod.
# Will only run if hostname contains "-dev-".
#
# When in doubt, flush the database before running.
#
Stella.load! :tryouts

def run
  attempt_to_bail
  uris = File.read('try/test-uris.txt').split($/)

  Stella.li "Flushing redis"
  Stella.redis.flushall

  Stella.li "Scrubbing database (%s)" % Stella.config['db.default.uri']
  DataMapper::Model.descendants.entries.each do |model|
    Stella.ld "Removing #{model} data..."
    begin
      model.destroy
    rescue => ex
      puts ex.message
    end
  end
  DataMapper.finalize.auto_migrate!

  cust = Stella::Customer.first_or_create :custid => :aaaaaaaaaaaaaaaa, :entropy=> :bbbbbbbb, :email => Stella.config['account.tech.email']

  Stella.li "Updating customer %s" % cust.email
  Stella::Customer.transaction do
    uris.each do |uri|
      uri = Stella::Utils.uri(uri)
      Stella.ld ' %s' % uri
      host = Stella::Host.first_or_create :customer => cust, :hostname => uri.host, :custid => cust.custid
      host.monitored = true
      host.settings = { :interval => 5.minutes }
      host.save
      plan = Stella::Testplan.first_or_create :host => host, :uri => uri, :enabled => true
    end
  end

end

def bail?
  ['prod', 'production'].member?(Stella.config['site.env']) ||
  Stella.sysinfo.hostname !~ /\-dev\-/ ||
  Stella.config['account.tech.email'].to_s.empty?
end
def attempt_to_bail
  return unless bail?
  Stella.li "This is not a dev machine"
  exit 1
end

run
