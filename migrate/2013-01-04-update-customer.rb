# 2013-01-04
# * Add columns to Customer

# ruby -Ilib -rstella migrate/2013-01-04-update-customer.rb [UP|DOWN]

require 'dm-migrations/migration_runner'

begin

  Stella.load_db

  migration 1, :add_deleted_at_to_customer do
    up do
      modify_table :stella_customers do
        add_column :deleted_at, Time
      end
    end
    down do
      modify_table :stella_customers do
        drop_column :deleted_at
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
