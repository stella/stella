# 2013-01-03
# * Drop contacts table
#
# ruby -Ilib -rstella migrate/2013-01-03-1-drop-contacts.rb [UP|DOWN]
#
# NOTE: This script assumes no customers have contact records (that's
# why we don't define a downward migration).
#
# Jan 03 @ 13:30:

#Stella.debug = true

require 'dm-migrations/migration_runner'

begin
  Stella.load!

  # http://www.ruby-doc.org/gems/docs/d/dm-migrations-1.2.0/DataMapper/Migration.html
  migration 1, :drop_contact_columns do
    up do
      drop_table :stella_contacts
    end
  end

  Stella.li "Starting db migration"
  case ARGV.first.to_s.upcase
  when "DOWN"
    migrate_down!
  when "UP"
    migrate_up!
  else
    Stella.li "Skipping"
  end

  Stella.li "Done."

rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end
