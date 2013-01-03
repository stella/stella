# 2013-01-03
# * Create customer contacts
#
# ruby -Ilib -rstella migrate/2013-01-03-1-create-contacts.rb
#
# NOTE: This script assumes no customers have contact records.
#
# Jan 03 @ 12:30:

#Stella.debug = true


begin
  Stella.load!

  # Recreate the contacts table
  DataMapper.finalize.auto_upgrade!

  Stella.li "Creating customer contact"
  cnt = 0
  customers = Stella::Customer.all
  customers.each do |cust|
    Stella::Logic.safedb do
      con = Stella::Contact.create :email => cust.email, :customer => cust
      cnt += 1
    end
  end

  Stella.li "Created %d contacts" % cnt
  Stella.li "Done."

rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end
