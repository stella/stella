# 2013-03-01
# * Updates incident table

# ruby -Ilib -rstella migrate/2013-03-01-incident.rb [UP|DOWN]

require 'dm-migrations'
require 'dm-migrations/migration_runner'

begin

  Stella.load_db

  migration 1, :add_dentid_at_to_incident do
    up do
      modify_table :stella_incidents do
        add_column :dentid, String
      end
    end
    down do
      modify_table :stella_incidents do
        drop_column :dentid
      end
    end
  end

  case ARGV.first.to_s.upcase
  when "DOWN"
    migrate_down!
  when "UP"
    migrate_up!
  else
    Stella.li "Skipping"
  end

rescue => ex
  puts "#{ex.class} #{ex.message}", ex.backtrace
  exit 1
end
