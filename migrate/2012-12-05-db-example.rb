# 2012-12-05
# * An example of database migrations

# ruby -Ilib -rstella migrate/2012-12-05-db-example.rb [DOWN]

require 'dm-migrations/migration_runner'

begin

  Stella.load_db

  migration 1, :create_people_table do
    up do
      create_table :people do
        column :id,   Integer, :serial => true
        column :name, String, :size => 50
        column :desc,  String
        column :age,  Integer
      end
    end
    down do
      drop_table :people
    end
  end


  migration 2, :make_desc_text do
    up do
      modify_table :people do
        # Datamapper 1.2.0: specify the underlying DB type here, rather than DM Type
        change_column :desc, 'TYPE text'
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
